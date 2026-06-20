{{- define "medikong-data.postgresql" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- $postgres := $root.Values.postgresql -}}
{{- $db := index $postgres.databases $key -}}
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
          resources:
{{ toYaml $postgres.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: {{ $postgres.storage }}
{{- end -}}
