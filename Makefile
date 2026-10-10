# Interim — developer entrypoints. Windows users without `make`: `npm run <target>` mirrors these.
SHELL := /bin/bash
PY ?= python3.12
VENV := .venv
ifeq ($(OS),Windows_NT)
  VPY := $(VENV)/Scripts/python.exe
else
  VPY := $(VENV)/bin/python
endif

.PHONY: help install install-py install-js dev api web bridge test test-rules test-api test-bridge test-web lint typecheck eval seed fetch-public demo-reset docker-up docker-down clean

help:
	@echo "make install      # python venv + editable installs + npm installs"
	@echo "make dev          # api :8000, web :5173, bridge :8787 (mock vitals)"
	@echo "make test         # rules + api + bridge + web unit/integration tests"
	@echo "make lint         # ruff/mypy/eslint/tsc"
	@echo "make eval         # replay personas through the live API -> docs/eval/results.md"
	@echo "make seed         # (re)create demo study + synthetic participants"
	@echo "make fetch-public # refresh data/public from ClinicalTrials.gov + openFDA (cached, --offline fallback)"
	@echo "make demo-reset   # wipe runtime DB and reseed"
	@echo "make docker-up    # docker compose up --build"

install: install-py install-js

install-py:
	@if command -v uv >/dev/null 2>&1; then \
	  uv venv --python 3.12 $(VENV) >/dev/null && uv pip install --python $(VPY) -e "packages/rules[dev]" -e "apps/api[dev]"; \
	else \
	  $(PY) -m venv $(VENV) && $(VPY) -m pip install --upgrade pip && $(VPY) -m pip install -e "packages/rules[dev]" -e "apps/api[dev]"; \
	fi

install-js:
	npm install
	cd apps/web && npm install
	cd apps/vitals-bridge && npm install

dev:
	npx concurrently -k -n api,web,bridge -c blue,green,magenta \
	  "$(MAKE) api" "$(MAKE) web" "$(MAKE) bridge"

api:
	cd apps/api && ../../$(VPY) -m uvicorn interim_api.main:app --reload --host 0.0.0.0 --port 8000

web:
	cd apps/web && npm run dev

bridge:
	cd apps/vitals-bridge && npm run bridge -- --source $${VITALS_SOURCE:-mock} --scenario $${VITALS_SCENARIO:-resting} --api $${BRIDGE_API_URL:-http://localhost:8000} --ws-port $${BRIDGE_WS_PORT:-8787}

test: test-rules test-api test-bridge test-web

test-rules:
	cd packages/rules && ../../$(VPY) -m pytest -q

test-api:
	cd apps/api && ../../$(VPY) -m pytest -q

test-bridge:
	cd apps/vitals-bridge && npm test

test-web:
	cd apps/web && npm test

lint:
	cd packages/rules && ../../$(VPY) -m ruff check . && ../../$(VPY) -m ruff format --check . && ../../$(VPY) -m mypy --strict interim_rules
	cd apps/api && ../../$(VPY) -m ruff check . && ../../$(VPY) -m ruff format --check .
	cd apps/vitals-bridge && npm run lint && npm run typecheck
	cd apps/web && npm run lint && npm run typecheck

typecheck: lint

eval:
	$(VPY) scripts/run_eval.py --api $${BRIDGE_API_URL:-http://localhost:8000} --out docs/eval/results.md

seed:
	$(VPY) scripts/seed.py

fetch-public:
	$(VPY) scripts/fetch_public.py

demo-reset:
	$(VPY) scripts/seed.py --reset

docker-up:
	docker compose up --build

docker-down:
	docker compose down -v

clean:
	rm -rf $(VENV) node_modules apps/web/node_modules apps/web/dist apps/vitals-bridge/node_modules apps/vitals-bridge/dist data/runtime
