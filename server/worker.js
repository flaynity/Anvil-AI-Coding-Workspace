const PRIVATE_HOSTNAMES = new Set(['localhost','localhost.localdomain','ip6-localhost','ip6-loopback','host.docker.internal']);

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0] || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Target-URL, Accept, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Type, X-Provider-Status',
    'Vary': 'Origin'
  };
}
function json(body,status,request,env,extra={}) {
  return new Response(JSON.stringify(body),{status,headers:{...cors(request,env),'Content-Type':'application/json',...extra}});
}
function privateIPv4(h){
  const p=h.split('.').map(Number);
  if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const[a,b]=p;
  return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
}
function privateIPv6(h){
  const x=h.toLowerCase();
  return x==='::'||x==='::1'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe8')||x.startsWith('fe9')||x.startsWith('fea')||x.startsWith('feb');
}
function target(raw){
  if(!raw||raw.length>2048)throw new Error('Missing or invalid target URL.');
  let u; try{u=new URL(raw)}catch{throw new Error('Target URL is not valid.')}
  if(u.protocol!=='https:')throw new Error('Target URL must use HTTPS.');
  if(u.username||u.password)throw new Error('Credentials in target URL are not allowed.');
  const h=u.hostname.toLowerCase().replace(/^\\[|\\]$/g,'');
  if(PRIVATE_HOSTNAMES.has(h)||h.endsWith('.local')||h.endsWith('.internal')||privateIPv4(h)||privateIPv6(h))throw new Error('Private or local target hosts are not allowed.');
  return u;
}
function upstreamHeaders(request){
  const h=new Headers();
  for(const[name,value]of request.headers){
    const n=name.toLowerCase();
    if(n==='authorization'||n==='content-type'||n==='accept'||n==='user-agent'||n.startsWith('x-')){
      if(n!=='x-target-url')h.set(name,value);
    }
  }
  return h;
}
export default {
  async fetch(request,env){
    const u=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(request,env)});

    if(u.pathname==='/health'){
      return json({
        ok:true,
        service:'flay-ai-gateway',
        githubBuildConfigured:Boolean(env.GITHUB_TOKEN),
        buildEndpoint:'/api/build',
        buildRunsEndpoint:'/api/build/runs',
        buildArtifactsEndpoint:'/api/build/artifacts',
        proxyEndpoint:'/api/proxy'
      },200,request,env);
    }

    if(u.pathname==='/api/build' || u.pathname==='/build'){
      if(request.method!=='POST')return json({error:'Method not allowed. Use POST.'},405,request,env,{'Allow':'POST, OPTIONS'});
      if(!env.GITHUB_TOKEN){
        return json({ok:false,error:'GITHUB_TOKEN is not configured on the Cloudflare Worker.'},503,request,env);
      }
      let body;
      try{body=await request.json();}catch{
        return json({ok:false,error:'Request body must be valid JSON.'},400,request,env);
      }
      const projectPath=typeof body.projectPath==='string'&&body.projectPath.trim()?body.projectPath.trim():'.';
      const buildType=body.buildType==='release'?'release':'debug';
      const dispatch=await fetch('https://api.github.com/repos/flaynity/Flay-AI/actions/workflows/android-build.yml/dispatches',{
        method:'POST',
        headers:{
          'Accept':'application/vnd.github+json',
          'Authorization':`Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version':'2026-03-10',
          'User-Agent':'Flay-AI-Cloudflare-Worker',
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          ref:'main',
          inputs:{project_path:projectPath,build_type:buildType}
        })
      });
      if(!dispatch.ok){
        const detail=await dispatch.text();
        return json({ok:false,error:'GitHub Actions build could not be started.',status:dispatch.status,detail},502,request,env);
      }
      return json({
        ok:true,
        status:'queued',
        workflow:'android-build.yml',
        projectPath,
        buildType,
        message:'Android build workflow dispatched. Use /api/build/runs to check the latest build.'
      },202,request,env);
    }

    if(u.pathname==='/api/build/runs'){
      if(request.method!=='GET')return json({error:'Method not allowed. Use GET.'},405,request,env,{'Allow':'GET, OPTIONS'});
      if(!env.GITHUB_TOKEN)return json({ok:false,error:'GITHUB_TOKEN is not configured on the Cloudflare Worker.'},503,request,env);
      const r=await fetch('https://api.github.com/repos/flaynity/Flay-AI/actions/workflows/android-build.yml/runs?branch=main&per_page=5',{
        headers:{
          'Accept':'application/vnd.github+json',
          'Authorization':`Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version':'2026-03-10',
          'User-Agent':'Flay-AI-Cloudflare-Worker'
        }
      });
      const data=await r.json();
      if(!r.ok)return json({ok:false,error:'Could not read GitHub Actions build status.',detail:data},502,request,env);
      return json({ok:true,runs:(data.workflow_runs||[]).map(x=>({
        id:x.id,
        status:x.status,
        conclusion:x.conclusion,
        html_url:x.html_url,
        created_at:x.created_at,
        updated_at:x.updated_at
      }))},200,request,env);
    }

    if(u.pathname==='/api/build/artifacts/download' || u.pathname==='/build/artifacts/download'){
      if(request.method!=='GET')return json({error:'Method not allowed. Use GET.'},405,request,env,{'Allow':'GET, OPTIONS'});
      if(!env.GITHUB_TOKEN)return json({ok:false,error:'GITHUB_TOKEN is not configured on the Cloudflare Worker.'},503,request,env);
      const artifactId=u.searchParams.get('artifact_id');
      if(!artifactId||!/^[0-9]+$/.test(artifactId))return json({ok:false,error:'A valid artifact_id is required.'},400,request,env);
      const r=await fetch(`https://api.github.com/repos/flaynity/Flay-AI/actions/artifacts/${artifactId}/zip`,{
        headers:{
          'Accept':'application/vnd.github+json',
          'Authorization':`Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version':'2026-03-10',
          'User-Agent':'Flay-AI-Cloudflare-Worker'
        },
        redirect:'follow'
      });
      if(!r.ok)return json({ok:false,error:'Could not download the build artifact.',status:r.status,detail:await r.text()},502,request,env);
      const h=new Headers(cors(request,env));
      h.set('Content-Type','application/zip');
      h.set('Content-Disposition','attachment; filename="flay-ai-apk.zip"');
      return new Response(r.body,{status:200,headers:h});
    }

    if(u.pathname==='/api/build/artifacts'){
      if(request.method!=='GET')return json({error:'Method not allowed. Use GET.'},405,request,env,{'Allow':'GET, OPTIONS'});
      if(!env.GITHUB_TOKEN)return json({ok:false,error:'GITHUB_TOKEN is not configured on the Cloudflare Worker.'},503,request,env);
      const runId=u.searchParams.get('run_id');
      if(!runId||!/^\d+$/.test(runId))return json({ok:false,error:'A valid run_id is required.'},400,request,env);
      const r=await fetch(`https://api.github.com/repos/flaynity/Flay-AI/actions/runs/${runId}/artifacts`,{
        headers:{
          'Accept':'application/vnd.github+json',
          'Authorization':`Bearer ${env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version':'2026-03-10',
          'User-Agent':'Flay-AI-Cloudflare-Worker'
        }
      });
      const data=await r.json();
      if(!r.ok)return json({ok:false,error:'Could not read build artifacts.',detail:data},502,request,env);
      return json({ok:true,artifacts:(data.artifacts||[]).map(x=>({
        id:x.id,
        name:x.name,
        size_in_bytes:x.size_in_bytes,
        expired:x.expired,
        created_at:x.created_at,
        expires_at:x.expires_at,
        archive_download_url:x.archive_download_url
      }))},200,request,env);
    }

    if(u.pathname!=='/api/proxy'){
      return json({
        ok:true,
        service:'flay-ai-gateway',
        endpoints:{health:'/health',build:'/api/build',buildRuns:'/api/build/runs',buildArtifacts:'/api/build/artifacts',proxy:'/api/proxy'}
      },200,request,env);
    }

    if(request.method!=='POST')return json({error:'Method not allowed. Use POST.'},405,request,env,{'Allow':'POST, OPTIONS'});
    let t;
    try{t=target(request.headers.get('X-Target-URL'))}catch(e){return json({error:e.message},400,request,env);}
    try{
      const r=await fetch(t.toString(),{method:'POST',headers:upstreamHeaders(request),body:request.body,redirect:'manual'});
      const h=new Headers(cors(request,env));
      const ct=r.headers.get('Content-Type'); if(ct)h.set('Content-Type',ct);
      h.set('X-Provider-Status',String(r.status));
      return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
    }catch(e){
      return json({error:'Proxy could not reach the provider.',detail:e?.message||'Upstream fetch failed.'},502,request,env);
    }
  }
};
