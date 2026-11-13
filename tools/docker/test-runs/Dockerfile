# Spike (#978): unit-test image. Dependencies only; source, ROMs and run-unit.sh arrive by bind mount.
# Build from the repo root: docker build -f tools/docker/test-runs/Dockerfile -t hackbench-unit:spike .
FROM node@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
LABEL hackbench.spike=uniform
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
ENTRYPOINT ["/run-unit.sh"]
