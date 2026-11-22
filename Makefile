.DEFAULT_GOAL := help

DAEMON_ARGS ?=

.PHONY: help run sim build-daemon web list-ports

help: ## Show the available commands
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*## "} {printf "  make %-14s %s\n", $$1, $$2}'

run: ## Build and run the laptop daemon for the boat (dashboard is hosted)
	./daemon/run.sh $(DAEMON_ARGS)

sim: ## Build and run the daemon with a simulated boat (no serial port)
	./daemon/run.sh --sim $(DAEMON_ARGS)

build-daemon: ## Build the daemon without starting it
	cmake -S daemon -B daemon/build -DCMAKE_BUILD_TYPE=Release
	cmake --build daemon/build --parallel --config Release

web: ## Run the dashboard locally at http://localhost:3000
	npm --prefix web-control run dev

list-ports: ## List serial ports detected by the daemon
	./daemon/run.sh --list-ports
