{{- define "read-api-loadtest.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "read-api-loadtest.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "read-api-loadtest.name" . -}}
{{- end -}}
{{- end -}}

{{- define "read-api-loadtest.namespace" -}}
{{- default .Release.Namespace .Values.namespace.name -}}
{{- end -}}

{{- define "read-api-loadtest.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "read-api-loadtest.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "read-api-loadtest.labels" -}}
{{- include "read-api-loadtest.labelsForScenario" (dict "root" . "scenario" .Values.loadtest.scenario) -}}
{{- end -}}

{{- define "read-api-loadtest.labelsForScenario" -}}
{{- $root := .root -}}
app.kubernetes.io/name: {{ include "read-api-loadtest.name" $root | quote }}
app.kubernetes.io/instance: {{ $root.Release.Name | quote }}
app.kubernetes.io/part-of: medikong
app.kubernetes.io/managed-by: {{ $root.Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | quote }}
medikong.io/environment: {{ $root.Values.environment | quote }}
medikong.io/test-type: {{ $root.Values.loadtest.testType | quote }}
medikong.io/scenario: {{ .scenario | quote }}
{{- end -}}

{{- define "read-api-loadtest.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $tag := required "image.tag is required" .Values.image.tag -}}
{{- with .Values.image.registry -}}
{{- printf "%s/%s:%s" (. | trimSuffix "/") $repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "read-api-loadtest.podSpec" -}}
{{- $root := .root -}}
{{- $scenario := .scenario -}}
{{- $credentialsSecretName := default "" .credentialsSecretName -}}
serviceAccountName: {{ include "read-api-loadtest.serviceAccountName" $root | quote }}
restartPolicy: Never
{{- with $root.Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . | quote }}
{{- end }}
{{- end }}
containers:
  - name: runner
    image: {{ include "read-api-loadtest.image" $root | quote }}
    imagePullPolicy: {{ $root.Values.image.pullPolicy | quote }}
    command:
      - /bin/sh
      - -ec
    args:
      - |
        set +e
        k6 run --log-format=raw ${K6_OUTPUT:+--out "$K6_OUTPUT"} {{- range $root.Values.k6.extraArgs }} {{ . | quote }}{{- end }} "/loadtest/scenarios/${LOADTEST_SCENARIO}.js"
        exit_code="$?"
        set -e
        case "${exit_code}" in
          0)
            exit 0
            ;;
          99|201)
            printf '{"event":"loadtest_threshold_exit","timestamp":"%s","test_type":"loadtest","loadtest_run_id":"%s","scenario":"%s","exit_code":%s}\\n' \
              "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOADTEST_RUN_ID:-}" "${LOADTEST_SCENARIO:-}" "${exit_code}"
            exit 0
            ;;
          *)
            exit "${exit_code}"
            ;;
        esac
    envFrom:
      - configMapRef:
          name: {{ include "read-api-loadtest.fullname" $root | quote }}
{{- if $credentialsSecretName }}
      - secretRef:
          name: {{ $credentialsSecretName | quote }}
          optional: false
{{- end }}
    env:
      - name: LOADTEST_RUN_ID
        valueFrom:
          fieldRef:
            fieldPath: metadata.name
      - name: LOADTEST_SCENARIO
        value: {{ $scenario | quote }}
{{- with $root.Values.extraEnv }}
{{ toYaml . | indent 6 }}
{{- end }}
    resources:
{{ toYaml $root.Values.resources | indent 6 }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
          - ALL
{{- end -}}
