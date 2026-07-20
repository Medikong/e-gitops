SHELL := /bin/sh

.DEFAULT_GOAL := help

TASK ?= task
SERVICE ?= order
ENV ?= dev
SCENARIO ?= network
IMAGE_TAG ?=
REGISTRY ?= 10.10.10.10:5000
ARCHIVED_LOCAL_APPS_KUSTOMIZATION ?= archive/k8s-kustomize/overlays/local/apps/kustomization.yaml

.PHONY: help validate render helm-lint helm-template helm-template-service helm-template-env scenario \
	helm-template-order-local helm-template-order-aws-dev helm-template-order-aws-prod \
	render-local-all render-aws-all update-local-image-tags apply-local-all status \
	metallb-bootstrap metallb-verify observability-install cluster-bootstrap cluster-verify \
	helm-bootstrap metrics-bootstrap metrics-verify registry-bootstrap registry-verify \
	registry-pull-verify observability-storage-bootstrap

help:
	@printf '%s\n' 'Medikong GitOps compatibility wrappers'
	@printf '%s\n' ''
	@printf '  %-42s %s\n' 'make validate' 'task validate'
	@printf '  %-42s %s\n' 'make render' 'task render'
	@printf '  %-42s %s\n' 'make helm-lint' 'task helm:lint'
	@printf '  %-42s %s\n' 'make helm-template SERVICE=order ENV=dev' 'task helm:template:one'
	@printf '  %-42s %s\n' 'make helm-template-service SERVICE=order' 'task helm:template:service'
	@printf '  %-42s %s\n' 'make helm-template-env ENV=dev' 'task helm:template:env'
	@printf '  %-42s %s\n' 'make scenario SCENARIO=network SERVICE=order' 'task scenario:render'
	@printf '%s\n' ''
	@printf '%s\n' 'Legacy targets are kept only as deprecated wrappers while archive/k8s-kustomize remains as reference.'

validate:
	$(TASK) validate

render:
	$(TASK) render

helm-lint:
	$(TASK) helm:lint

helm-template:
	$(TASK) helm:template:one SERVICE=$(SERVICE) ENV=$(ENV)

helm-template-service:
	$(TASK) helm:template:service SERVICE=$(SERVICE)

helm-template-env:
	$(TASK) helm:template:env ENV=$(ENV)

scenario:
	$(TASK) scenario:render SERVICE=$(SERVICE) SCENARIO=$(SCENARIO)

helm-template-order-local:
	@printf '%s\n' 'Deprecated: use make helm-template SERVICE=order ENV=local-vm-kubeadm' >&2
	$(TASK) helm:template:one SERVICE=order ENV=local-vm-kubeadm

helm-template-order-aws-dev:
	@printf '%s\n' 'Deprecated: use make helm-template SERVICE=order ENV=aws-dev' >&2
	$(TASK) helm:template:one SERVICE=order ENV=aws-dev

helm-template-order-aws-prod:
	@printf '%s\n' 'Deprecated: use make helm-template SERVICE=order ENV=aws-prod' >&2
	$(TASK) helm:template:one SERVICE=order ENV=aws-prod

render-local-all:
	@printf '%s\n' 'Deprecated: k8s Kustomize is archived under archive/k8s-kustomize and is no longer an operating path.' >&2
	kubectl kustomize archive/k8s-kustomize/overlays/local/all >/dev/null

render-aws-all:
	@printf '%s\n' 'Deprecated: k8s Kustomize is archived under archive/k8s-kustomize and is no longer an operating path.' >&2
	kubectl kustomize archive/k8s-kustomize/overlays/aws/all >/dev/null

update-local-image-tags:
	@printf '%s\n' 'Deprecated: image tags should move through values/services/* or values/overrides/*.' >&2
	@if [ -z "$(IMAGE_TAG)" ]; then \
		printf '%s\n' 'IMAGE_TAG is required, for example: make update-local-image-tags IMAGE_TAG=dev-001' >&2; \
		exit 2; \
	fi
	cluster/scripts/update-local-image-tags.sh "$(IMAGE_TAG)" "$(ARCHIVED_LOCAL_APPS_KUSTOMIZATION)" "$(REGISTRY)"

apply-local-all status metallb-bootstrap metallb-verify observability-install cluster-bootstrap cluster-verify helm-bootstrap metrics-bootstrap metrics-verify registry-bootstrap registry-verify registry-pull-verify observability-storage-bootstrap:
	@printf '%s\n' 'Deprecated: this Makefile is now only a Taskfile compatibility wrapper. Use the cluster docs/scripts directly for legacy cluster operations.' >&2
	@exit 2
