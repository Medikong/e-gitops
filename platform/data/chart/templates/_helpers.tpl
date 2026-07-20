{{- define "medikong-data.postgresql" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- $postgres := $root.Values.postgresql -}}
{{- $exporter := default dict $postgres.exporter -}}
{{- $exporterServiceMonitor := default dict $exporter.serviceMonitor -}}
{{- $db := index $postgres.databases $key -}}
{{- $credentialsSecret := default dict $db.credentialsSecret -}}
{{- if $credentialsSecret.create }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ required "postgresql.databases[].credentialsSecret.name is required" $credentialsSecret.name | quote }}
  namespace: {{ $db.namespace | quote }}
  labels:
    app.kubernetes.io/part-of: medikong
    app.kubernetes.io/name: {{ $db.name | quote }}
type: Opaque
stringData:
  password: {{ $postgres.password | quote }}
  database-url: {{ printf "%s://%s:%s@%s:5432/%s?sslmode=%s" (default "postgres" $credentialsSecret.scheme) ($postgres.user | urlquery) ($postgres.password | urlquery) (default $db.name $credentialsSecret.host) $db.database (default "disable" $credentialsSecret.sslMode) | quote }}
---
{{- end }}
apiVersion: v1
kind: Service
metadata:
  name: {{ $db.name | quote }}
  namespace: {{ $db.namespace | quote }}
  labels:
    app.kubernetes.io/part-of: medikong
    app.kubernetes.io/name: {{ $db.name | quote }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ $db.name | quote }}
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
{{- if $exporter.enabled }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ printf "%s-metrics" $db.name | quote }}
  namespace: {{ $db.namespace | quote }}
  labels:
    app.kubernetes.io/part-of: medikong
    app.kubernetes.io/name: {{ $db.name | quote }}
    app.kubernetes.io/component: postgresql-exporter
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ $db.name | quote }}
  ports:
    - name: pg-metrics
      port: {{ $exporter.port }}
      targetPort: pg-metrics
{{- if $exporterServiceMonitor.enabled }}
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ printf "%s-metrics" $db.name | quote }}
  namespace: {{ $db.namespace | quote }}
  labels:
    app.kubernetes.io/part-of: medikong
    app.kubernetes.io/name: {{ $db.name | quote }}
    app.kubernetes.io/component: postgresql-exporter
{{- with $exporterServiceMonitor.labels }}
{{ toYaml . | nindent 4 }}
{{- end }}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $db.name | quote }}
      app.kubernetes.io/component: postgresql-exporter
  namespaceSelector:
    matchNames:
      - {{ $db.namespace | quote }}
  endpoints:
    - port: pg-metrics
      path: {{ default "/metrics" $exporterServiceMonitor.path | quote }}
      interval: {{ default "30s" $exporterServiceMonitor.interval | quote }}
{{- end }}
{{- end }}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ $db.name | quote }}
  namespace: {{ $db.namespace | quote }}
  labels:
    app.kubernetes.io/part-of: medikong
    app.kubernetes.io/name: {{ $db.name | quote }}
spec:
  serviceName: {{ $db.name | quote }}
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $db.name | quote }}
  template:
    metadata:
      labels:
        app.kubernetes.io/part-of: medikong
        app.kubernetes.io/name: {{ $db.name | quote }}
    spec:
      containers:
        - name: postgres
          image: {{ $postgres.image | quote }}
          args:
            - -c
            - shared_buffers={{ $postgres.config.sharedBuffers }}
            - -c
            - effective_cache_size={{ $postgres.config.effectiveCacheSize }}
            - -c
            - work_mem={{ $postgres.config.workMem }}
            - -c
            - maintenance_work_mem={{ $postgres.config.maintenanceWorkMem }}
            - -c
            - max_connections={{ $postgres.config.maxConnections }}
          ports:
            - name: postgres
              containerPort: 5432
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - {{ $postgres.user | quote }}
                - -d
                - {{ $db.database | quote }}
            initialDelaySeconds: 5
            periodSeconds: 5
          env:
            - name: POSTGRES_USER
              value: {{ $postgres.user | quote }}
            - name: POSTGRES_PASSWORD
              value: {{ $postgres.password | quote }}
            - name: POSTGRES_DB
              value: {{ $db.database | quote }}
            - name: PGDATA
              value: {{ $postgres.pgData | quote }}
          resources:
{{ toYaml $postgres.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
{{- if $exporter.enabled }}
        - name: postgres-exporter
          image: {{ $exporter.image | quote }}
          ports:
            - name: pg-metrics
              containerPort: {{ $exporter.port }}
          env:
            - name: DATA_SOURCE_NAME
              value: {{ printf "postgresql://%s:%s@localhost:5432/%s?sslmode=disable" $postgres.user $postgres.password $db.database | quote }}
          resources:
{{ toYaml $exporter.resources | nindent 12 }}
{{- end }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
{{- if $postgres.storageClassName }}
        storageClassName: {{ $postgres.storageClassName | quote }}
{{- end }}
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: {{ $postgres.storage }}
{{- end -}}
