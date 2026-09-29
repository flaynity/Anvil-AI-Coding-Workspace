FROM eclipse-temurin:17-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    GRADLE_USER_HOME=/opt/gradle-cache \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip git ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip \
    && yes | sdkmanager --licenses >/dev/null || true \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && chmod -R a+rX /opt/android-sdk

RUN curl -fsSL https://services.gradle.org/distributions/gradle-8.10.2-bin.zip -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s /opt/gradle-8.10.2 /opt/gradle \
    && rm /tmp/gradle.zip

ENV PATH=/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app
COPY build-server/package.json ./package.json
RUN npm install --omit=dev
COPY build-server/server.js ./server.js
COPY index.html ./index.html

RUN mkdir -p /opt/gradle-cache /tmp/flay-builds

EXPOSE 8080
CMD ["node", "server.js"]
