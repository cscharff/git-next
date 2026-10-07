# org-baseline (fixture)

What an org publishes so new repos start smart: the org, contract and tool instruction layers, default
stack ranks (`.gitnext/stack.json`), the catalog of approved models, resources, tools and checks
(`catalog.json`), and repo templates (`templates/worker-api`). `git next new <name> --template worker-api`
copies a template from here, vendors the layers at a pinned version, copies the catalog and installs the hook.

In production this is an Artifacts repo that new repos fork (keeping provenance); here it is a folder.
