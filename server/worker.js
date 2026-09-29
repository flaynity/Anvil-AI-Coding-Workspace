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
        buildConfigured:Boolean(env.BUILD_SERVER_URL),
        buildEndpoint:'/api/build',
        proxyEndpoint:'/api/proxy'
      },200,request,env);
    }

    if(u.pathname==='/api/build'){
      if(request.method!=='POST')return json({error:'Method not allowed. Use POST.'},405,request,env,{'Allow':'POST, OPTIONS'});
      if(!env.BUILD_SERVER_URL){
        return json({
          ok:false,
          error:'BUILD_SERVER_URL is not configured. The Cloudflare Worker gateway is ready, but an Android build server must be connected.'
        },503,request,env);
      }
      let base;
      try{base=new URL(env.BUILD_SERVER_URL)}catch{
        return json({ok:false,error:'BUILD_SERVER_URL is invalid.'},500,request,env);
      }
      if(base.protocol!=='https:')return json({ok:false,error:'BUILD_SERVER_URL must use HTTPS.'},500,request,env);
      try{
        const body=await request.text();
        const h=new Headers({
          'Content-Type':'application/json',
          'Accept':'application/vnd.android.package-archive,application/json'
        });
        const auth=request.headers.get('Authorization');
        if(auth)h.set('Authorization',auth);
        const r=await fetch(new URL('/build',base).toString(),{
          method:'POST',
          headers:h,
          body
        });
        const headers={
          ...cors(request,env),
          'Content-Type':r.headers.get('Content-Type')||'application/json'
        };
        const disposition=r.headers.get('Content-Disposition');
        if(disposition)headers['Content-Disposition']=disposition;
        return new Response(r.body,{status:r.status,statusText:r.statusText,headers});
      }catch(e){
        return json({
          ok:false,
          error:'Android build server could not be reached.',
          detail:e?.message||'Upstream build request failed.'
        },502,request,env);
      }
    }

    if(u.pathname!=='/api/proxy'){
      return json({
        ok:true,
        service:'flay-ai-gateway',
        endpoints:{health:'/health',build:'/api/build',proxy:'/api/proxy'}
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
