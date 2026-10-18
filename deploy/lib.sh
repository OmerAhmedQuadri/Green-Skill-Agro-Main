# Sourced by the deploy scripts, from the repository folder (ADR-0058): which
# copy of the app this folder is — APP_INSTANCE in its .env — what it uses, and
# Docker Compose for its database.
INSTANCE=$(node deploy/instance.cjs . name)
APP_PORT=$(node deploy/instance.cjs . port)
BRANCH=$(node deploy/instance.cjs . branch)
WEB=$(node deploy/instance.cjs . web)
WORKER=$(node deploy/instance.cjs . worker)
# Compose reads the published port from the environment.
POSTGRES_PORT=$(node deploy/instance.cjs . dbPort)
export POSTGRES_PORT
COMPOSE=(docker compose -p "$(node deploy/instance.cjs . project)" --env-file .env -f deploy/docker-compose.yml)
