FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Python 运行时（pytest）；镜像已自带 Node 20 与 Playwright 浏览器。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

COPY verify/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /work

# 前端依赖（供 Vitest 使用）。
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY web/ web/

# 验收器自身依赖（@playwright/test，版本与基础镜像浏览器对齐）。
COPY verify/package.json verify/package-lock.json* verify/
RUN cd verify && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)
COPY verify/ verify/

WORKDIR /work/verify
CMD ["bash", "run.sh"]
