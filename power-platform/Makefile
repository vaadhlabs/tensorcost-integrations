# TensorCost for Power Platform. `make validate test` is the whole check.
#
#   validate         paconn validate, Microsoft's own schema check, when paconn
#                    is installed. Without it the target says so and passes;
#                    `make validate-strict` fails instead. `make test` checks
#                    the same files without paconn.
#   test             The Node checks in tests/: OpenAPI 2.0 structure, every
#                    operation against the admit contract, and the requests
#                    replayed against the admit mock on localhost. Needs only
#                    Node 18.17 or later.
#   icon             Rebuilds TensorCost/icon.png.
#   deploy           Pushes the connector to the environment paconn is logged
#                    in to (`paconn login` first). Not part of `make`'s checks.

CONNECTOR := TensorCost
PACONN    := $(shell command -v paconn 2>/dev/null)

.PHONY: all validate validate-strict test icon deploy

all: validate test

validate:
ifeq ($(PACONN),)
	@echo "validate: paconn is not installed, so Microsoft's schema check did not run."
	@echo "          pip install paconn, then make validate-strict. 'make test' checks the same files without it."
else
	paconn validate --api-def $(CONNECTOR)/apiDefinition.swagger.json
endif

validate-strict:
ifeq ($(PACONN),)
	@echo "validate-strict: paconn is not installed (pip install paconn)." >&2
	@exit 1
else
	paconn validate --api-def $(CONNECTOR)/apiDefinition.swagger.json
endif

test:
	node --test tests/*.test.mjs

icon:
	node scripts/make-icon.mjs

deploy:
	paconn create --api-prop $(CONNECTOR)/apiProperties.json --api-def $(CONNECTOR)/apiDefinition.swagger.json --icon $(CONNECTOR)/icon.png --secrets settings.json
