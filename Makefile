# Interim — developer entrypoints. Windows users without `make`: `npm run <target>` mirrors these.
# The same commands run in CI (.github/workflows/ci.yml).
SHELL := /bin/bash
PY ?= python3.12
VENV := .venv
ifeq ($(OS),Windows_NT)
  VPY := $(VENV)/Scripts/python.exe
else
  VPY := $(VENV)/bin/python
endif

# ---- configuration: the optional repo-root .env (copy .env.example) ---------------------------
# The API reads .env itself (pydantic-settings). The bridge reads only its process environment,
# so make picks the knobs below out of .env and exports them to every recipe (`make dev`,
# `make bridge`, ...). Only these keys are read; nothing else in .env changes make's behaviour.
# Precedence: `make VAR=x` > the shell environment > .env > built-in defaults.
ENV_KEYS := API_HOST API_PORT VITALS_SOURCE VITALS_SCENARIO VITALS_MIN_CONF BRIDGE_TOKEN
ENV_KEYS += BRIDGE_WS_HOST BRIDGE_WS_PORT BRIDGE_API_URL BRIDGE_ALLOWED_ORIGINS SERIALPORT
ENV_KEYS += PRESAGE_API_KEY PRESAGE_CAMERA_ID
ifneq ($(wildcard .env),)
# Last `KEY=value` line wins; CRLF line endings are tolerated. Keys already set are left alone.
$(foreach k,$(ENV_KEYS),$(if $(filter undefined,$(origin $(k))),$(eval $(k) := $(shell sed -n 's/^$(k)=//p' .env | tr -d '\r' | tail -n 1))))
endif
# Export only non-empty values (an empty VITALS_SOURCE would fail the API's settings validation).
# Never a bare `export` with an empty list: that would export every make variable.
$(foreach k,$(ENV_KEYS),$(if $($(k)),$(eval export $(k))))

.PHONY: help install install-py install-js dev api web bridge test test-rules test-api test-scripts test-bridge test-web lint typecheck eval eval-live seed fetch-public demo-reset docker-build docker-up docker-down docker-logs ci clean

help:
	@echo "make install      # python venv + editable installs + npm installs"
	@echo "make dev          # api :8000, web :5173, bridge :8787 (VITALS_SOURCE from env/.env, default mock)"
	@echo "make test         # rules + api + scripts + bridge + web unit/integration tests"
	@echo "make lint         # ruff/mypy/eslint/tsc"
	@echo "make eval         # start a throwaway API, replay personas + chart notes -> docs/eval/results.md (must be 100%)"
	@echo "make eval-live    # same, against the API already running on :8000"
	@echo "make seed         # (re)create demo study + synthetic participants"
	@echo "make fetch-public # refresh data/public from ClinicalTrials.gov + openFDA (cached, --offline fallback)"
	@echo "make demo-reset   # wipe runtime DB and reseed"
	@echo "make docker-up    # docker compose up --build (kiosk :5173/kiosk, API :8000/docs, bridge :8787 mock)"
	@echo "make docker-down  # stop the stack and delete its database volume"
	@echo "make ci           # lint + test + eval, as CI runs them"

install: install-py install-js

install-py:
	@if command -v uv >/dev/null 2>&1; then \
	  uv venv --python 3.12 $(VENV) >/dev/null && uv pip install --python $(VPY) -e "packages/rules[dev]" -e "apps/api[dev]" openpyxl==3.1.5; \
	else \
	  $(PY) -m venv $(VENV) && $(VPY) -m pip install --upgrade pip && $(VPY) -m pip install -e "packages/rules[dev]" -e "apps/api[dev]" openpyxl==3.1.5; \
	fi

# `npm ci` installs exactly the committed lockfiles and never rewrites them.
install-js:
	npm ci --no-audit --no-fund
	cd apps/web && npm ci --no-audit --no-fund
	cd apps/vitals-bridge && npm ci --no-audit --no-fund

dev:
	npx concurrently -k -n api,web,bridge -c blue,green,magenta \
	  "$(MAKE) api" "$(MAKE) web" "$(MAKE) bridge"

api:
	cd apps/api && ALLOW_DEMO_RESET=$${ALLOW_DEMO_RESET:-true} ../../$(VPY) -m uvicorn interim_api.main:app --reload --host $${API_HOST:-0.0.0.0} --port $${API_PORT:-8000}

web:
	cd apps/web && npm run dev

bridge:
	cd apps/vitals-bridge && npm run bridge -- --source $${VITALS_SOURCE:-mock} --scenario $${VITALS_SCENARIO:-resting} --api $${BRIDGE_API_URL:-http://localhost:8000} --ws-port $${BRIDGE_WS_PORT:-8787}

test: test-rules test-api test-scripts test-bridge test-web

test-rules:
	cd packages/rules && ../../$(VPY) -m pytest -q --cov=interim_rules --cov-branch --cov-report=term --cov-fail-under=95

test-api:
	cd apps/api && ../../$(VPY) -m pytest -q

test-scripts:
	$(VPY) scripts/fetch_public.py --offline --strict
	cd scripts && ../$(VPY) -m pytest -q
	@if [ -d scripts/synthea ]; then \
	  $(VPY) scripts/synthea/import_synthea.py --check && $(VPY) scripts/synthea/eval_synthea.py --check; \
	fi

test-bridge:
	cd apps/vitals-bridge && npm test

test-web:
	cd apps/web && npm test

lint:
	cd packages/rules && ../../$(VPY) -m ruff check . && ../../$(VPY) -m ruff format --check . && ../../$(VPY) -m mypy --strict interim_rules
	cd apps/api && ../../$(VPY) -m ruff check . && ../../$(VPY) -m ruff format --check .
	cd scripts && ../$(VPY) -m ruff check . && ../$(VPY) -m ruff format --check . && MYPYPATH=../packages/rules ../$(VPY) -m mypy
	cd apps/vitals-bridge && npm run lint && npm run typecheck
	cd apps/web && npm run lint && npm run typecheck

typecheck: lint

eval:
	$(VPY) scripts/run_eval.py --start-server --include-hidden --strict --out docs/eval/results.md

eval-live:
	$(VPY) scripts/run_eval.py --api $${BRIDGE_API_URL:-http://localhost:8000}

seed:
	$(VPY) scripts/seed.py

fetch-public:
	$(VPY) scripts/fetch_public.py

demo-reset:
	$(VPY) scripts/seed.py --reset

docker-build:
	docker compose build

docker-up:
	docker compose up --build

docker-down:
	docker compose down -v

docker-logs:
	docker compose logs -f --tail 100

ci: lint test eval

clean:
	rm -rf $(VENV) node_modules apps/web/node_modules apps/web/dist apps/vitals-bridge/node_modules apps/vitals-bridge/dist data/runtime
