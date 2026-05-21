#!/usr/bin/env bash
set -euo pipefail

registry="${LOCAL_REGISTRY:-10.10.10.10:5000}"
registry_host="${LOCAL_REGISTRY_HOST:-10.10.10.10}"
inventory_path="${ANSIBLE_INVENTORY:-}"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/medikong-gitops/cluster"
cache_ca="${cache_dir}/${registry}-ca.crt"

log() {
  printf "%s\n" "$*"
}

load_wsl_sudo_password() {
  if [ -n "${WSL_SUDO_PASSWORD:-}" ] || [ ! -f ".env" ]; then
    return 0
  fi

  WSL_SUDO_PASSWORD="$(
    awk '
      /^WSL_SUDO_PASSWORD=/ {
        sub(/^WSL_SUDO_PASSWORD=/, "")
        sub(/\r$/, "")
        print
        exit
      }
    ' .env
  )"
  export WSL_SUDO_PASSWORD
}

sudo_run() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif [ -n "${WSL_SUDO_PASSWORD:-}" ]; then
    printf "%s\n" "${WSL_SUDO_PASSWORD}" | sudo -S -p "" "$@"
  else
    sudo "$@"
  fi
}

is_wsl() {
  grep -qiE "microsoft|wsl" /proc/version 2>/dev/null
}

if [ -z "${inventory_path}" ] || [ ! -f "${inventory_path}" ]; then
  log "missing: ANSIBLE_INVENTORY"
  log "set ANSIBLE_INVENTORY to an inventory prepared by the infra repo"
  exit 1
fi

inventory_value() {
  local name="$1"
  awk -v name="${name}" '
    $1 == "control-plane-1" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ "^" name "=") {
          sub("^" name "=", "", $i)
          print $i
          exit
        }
      }
    }
  ' "${inventory_path}"
}

ssh_user="${LOCAL_VM_SSH_USER:-$(inventory_value ansible_user)}"
ssh_host="${LOCAL_VM_SSH_HOST:-$(inventory_value ansible_host)}"
ssh_port="${LOCAL_VM_SSH_PORT:-$(inventory_value ansible_port)}"
inventory_ssh_key="$(inventory_value ansible_ssh_private_key_file)"
ssh_key="${LOCAL_VM_SSH_PRIVATE_KEY:-${inventory_ssh_key}}"

if [ -z "${ssh_user}" ] || [ -z "${ssh_host}" ] || [ -z "${ssh_port}" ] || [ -z "${ssh_key}" ]; then
  log "missing: control-plane-1 SSH settings in ${inventory_path}"
  log "set ANSIBLE_INVENTORY to an inventory prepared by the infra repo"
  exit 1
fi

if [ ! -f "${ssh_key}" ] && [ -n "${inventory_ssh_key}" ] && [ -f "${inventory_ssh_key}" ]; then
  log "warning: LOCAL_VM_SSH_PRIVATE_KEY is not accessible: ${ssh_key}"
  log "using inventory key instead: ${inventory_ssh_key}"
  ssh_key="${inventory_ssh_key}"
fi

if [ ! -f "${ssh_key}" ]; then
  log "missing: SSH private key ${ssh_key}"
  log "set LOCAL_VM_SSH_PRIVATE_KEY or use an inventory with an accessible ansible_ssh_private_key_file"
  exit 1
fi

fetch_ca() {
  mkdir -p "${cache_dir}"
  if ! ssh -i "${ssh_key}" \
    -p "${ssh_port}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "${ssh_user}@${ssh_host}" \
    "sudo test -f /etc/docker/registry/tls/ca.crt"; then
    log "missing: /etc/docker/registry/tls/ca.crt on ${registry_host}"
    log "run this first: make registry-bootstrap"
    exit 1
  fi

  ssh -i "${ssh_key}" \
    -p "${ssh_port}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "${ssh_user}@${ssh_host}" \
    "sudo cat /etc/docker/registry/tls/ca.crt" > "${cache_ca}"
  log "fetched: ${cache_ca}"
}

install_user_docker_cert() {
  local target="${HOME}/.docker/certs.d/${registry}/ca.crt"
  mkdir -p "$(dirname "${target}")"
  install -m 0644 "${cache_ca}" "${target}"
  log "installed Docker user cert: ${target}"
}

install_linux_engine_cert() {
  local target="/etc/docker/certs.d/${registry}/ca.crt"
  if command -v sudo >/dev/null 2>&1; then
    load_wsl_sudo_password
    sudo_run mkdir -p "$(dirname "${target}")"
    sudo_run install -m 0644 "${cache_ca}" "${target}"
    log "installed Docker engine cert: ${target}"
  else
    log "skip: sudo is not available; install ${cache_ca} to ${target} manually."
  fi
}

install_windows_docker_desktop_cert() {
  if ! command -v powershell.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
    log "skip: powershell.exe or wslpath is not available; this does not look like Docker Desktop on WSL."
    return 0
  fi

  local ca_windows_path
  ca_windows_path="$(wslpath -w "${cache_ca}")"

  if powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
    "\$ca='${ca_windows_path}'; Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue; if (-not (Get-PSDrive -Name Cert -ErrorAction SilentlyContinue)) { throw 'PowerShell Cert provider is not available' }; Import-Certificate -FilePath \$ca -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null" \
    >/dev/null; then
    log "imported CA into Windows CurrentUser Root certificate store"
  elif command -v cmd.exe >/dev/null 2>&1 && cmd.exe /C "certutil -user -addstore Root \"${ca_windows_path}\"" >/dev/null; then
    log "imported CA into Windows CurrentUser Root certificate store with certutil"
  else
    log "warning: could not import CA into Windows CurrentUser Root certificate store."
    log "manual command from WSL:"
    log "  cmd.exe /C 'certutil -user -addstore Root \"${ca_windows_path}\"'"
    log "continuing because the WSL Docker engine certificate was installed."
    return 0
  fi

  log "restart Docker Desktop if docker push still reports x509 or HTTPS errors."
}

delete_macos_cert_by_name() {
  local keychain="$1"
  local common_name="$2"
  local removed=0

  while security find-certificate -c "${common_name}" "${keychain}" >/dev/null 2>&1; do
    security delete-certificate -c "${common_name}" "${keychain}" >/dev/null
    removed=$((removed + 1))
    if [ "${removed}" -gt 20 ]; then
      log "failed: too many ${common_name} certificates found in ${keychain}"
      exit 1
    fi
  done
}

install_macos_docker_desktop_cert() {
  if ! command -v security >/dev/null 2>&1; then
    log "skip: security command is not available; add ${cache_ca} to Keychain as a trusted root manually."
    return 0
  fi

  local keychain="${HOME}/Library/Keychains/login.keychain-db"

  delete_macos_cert_by_name "${keychain}" "cloudnative-local-registry-ca"
  delete_macos_cert_by_name "${keychain}" "dev-env-bootstrap-local-registry-ca"

  security add-trusted-cert -d -r trustRoot -k "${keychain}" "${cache_ca}"
  log "trusted Docker Desktop CA in macOS login keychain: ${keychain}"
  log "restart Docker Desktop before retrying docker push."
}

fetch_ca
install_user_docker_cert

case "$(uname -s)" in
  Darwin)
    install_macos_docker_desktop_cert
    ;;
  Linux)
    install_linux_engine_cert
    if is_wsl; then
      install_windows_docker_desktop_cert
    fi
    ;;
  *)
    log "unknown OS. CA was fetched to ${cache_ca}; install it into your Docker engine trust store."
    ;;
esac
