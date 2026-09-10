.PHONY: local-env-start local-env-reset local-env-smoke local-env-status local-env-stop local-env-destroy local-env-measure

local-env-start:
	./scripts/local-env start

local-env-reset:
	./scripts/local-env reset

local-env-smoke:
	./scripts/local-env smoke

local-env-status:
	./scripts/local-env status

local-env-stop:
	./scripts/local-env stop

local-env-destroy:
	./scripts/local-env destroy

local-env-measure:
	./scripts/local-env measure
