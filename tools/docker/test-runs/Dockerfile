# Spike (#978): unit-test image. Dependencies only; source and ROMs arrive by bind mount.
# TODO: pin node:22-bookworm by digest once `docker pull` works (Docker Desktop was down).
FROM node:22-bookworm
LABEL hackbench.spike=uniform
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY run-unit.sh /usr/local/bin/run-unit.sh
RUN chmod +x /usr/local/bin/run-unit.sh
ENTRYPOINT ["/usr/local/bin/run-unit.sh"]
