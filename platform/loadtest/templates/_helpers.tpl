{{- define "dropmong-loadtest.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dropmong-loadtest.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "dropmong-loadtest.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "dropmong-loadtest.namespace" -}}
{{- default .Release.Namespace .Values.namespace.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dropmong-loadtest.workloadName" -}}
{{- $root := .root -}}
{{- $role := required "workload role is required" .role -}}
{{- $name := printf "%s-%s-%s" (include "dropmong-loadtest.fullname" $root) $role $root.Values.run.trialId -}}
{{- if gt (len $name) 63 -}}
{{- printf "%s-%s" ($name | trunc 54 | trimSuffix "-") ($name | sha256sum | trunc 8) -}}
{{- else -}}
{{- $name -}}
{{- end -}}
{{- end -}}

{{- define "dropmong-loadtest.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "dropmong-loadtest.fullname" .) .Values.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "dropmong-loadtest.commonLabels" -}}
{{- $root := .root -}}
{{- $role := required "role is required for load-test labels" .role -}}
app.kubernetes.io/name: {{ include "dropmong-loadtest.name" $root | quote }}
app.kubernetes.io/instance: {{ $root.Release.Name | quote }}
app.kubernetes.io/part-of: dropmong
app.kubernetes.io/managed-by: {{ $root.Release.Service | quote }}
app.kubernetes.io/component: loadtest
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | quote }}
loadtest.dropmong.io/run-id: {{ required "run.id is required" $root.Values.run.id | quote }}
loadtest.dropmong.io/service: {{ required "run.service is required" $root.Values.run.service | quote }}
loadtest.dropmong.io/trial-id: {{ required "run.trialId is required" $root.Values.run.trialId | quote }}
loadtest.dropmong.io/role: {{ $role | quote }}
{{- end -}}

{{- define "dropmong-loadtest.image" -}}
{{- $image := .image -}}
{{- $repository := required "image.repository is required" $image.repository -}}
{{- $tag := trim (toString (default "" $image.tag)) -}}
{{- $digest := trim (toString (default "" $image.digest)) -}}
{{- if eq (ne $tag "") (ne $digest "") -}}
{{- fail "exactly one of image.tag or image.digest must be set" -}}
{{- end -}}
{{- $base := $repository -}}
{{- with $image.registry -}}
{{- $base = printf "%s/%s" (trimSuffix "/" .) (trimPrefix "/" $repository) -}}
{{- end -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "image.digest must match sha256 followed by 64 lowercase hexadecimal characters" -}}
{{- end -}}
{{- printf "%s@%s" $base $digest -}}
{{- else -}}
{{- printf "%s:%s" $base $tag -}}
{{- end -}}
{{- end -}}

{{- define "dropmong-loadtest.reportClaimName" -}}
{{- if .Values.reportArchive.existingClaim -}}
{{- .Values.reportArchive.existingClaim -}}
{{- else if .Values.reportArchive.enabled -}}
{{- printf "%s-%s-reports" (include "dropmong-loadtest.fullname" .) .Values.run.id | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- fail "reportArchive.enabled or reportArchive.existingClaim is required for load-test workloads" -}}
{{- end -}}
{{- end -}}

{{- define "dropmong-loadtest.reportDir" -}}
{{- printf "%s/%s" (trimSuffix "/" .Values.reportArchive.mountPath) .Values.run.id -}}
{{- end -}}

{{- define "dropmong-loadtest.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "dropmong-loadtest.scheduling" -}}
{{- with .Values.scheduling.nodeSelector }}
nodeSelector:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.scheduling.tolerations }}
tolerations:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.scheduling.affinity }}
affinity:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "dropmong-loadtest.commonEnvFrom" -}}
{{- $root := .root -}}
{{- $existingSecrets := default (list) .existingSecrets -}}
- configMapRef:
    name: {{ include "dropmong-loadtest.fullname" $root | quote }}
{{- range $secretName := $existingSecrets }}
- secretRef:
    name: {{ required "existingSecrets entries must not be empty" $secretName | quote }}
    optional: false
{{- end }}
{{- end -}}

{{- define "dropmong-loadtest.commonEnv" -}}
{{- $root := .root -}}
- name: LOADTEST_REPORT_DIR
  value: {{ include "dropmong-loadtest.reportDir" $root | quote }}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
{{- end -}}

{{- define "dropmong-loadtest.commonVolumes" -}}
- name: reports
  persistentVolumeClaim:
    claimName: {{ include "dropmong-loadtest.reportClaimName" . | quote }}
- name: tmp
  emptyDir: {}
{{- end -}}

{{- define "dropmong-loadtest.commonVolumeMounts" -}}
{{- $root := . -}}
- name: reports
  mountPath: {{ $root.Values.reportArchive.mountPath | quote }}
- name: tmp
  mountPath: /tmp
{{- end -}}
