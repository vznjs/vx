{{/*
Chart name, overridable.
*/}}
{{- define "vx-cloud.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified release name (used as the resource name prefix).
*/}}
{{- define "vx-cloud.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label (name-version).
*/}}
{{- define "vx-cloud.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every object.
*/}}
{{- define "vx-cloud.labels" -}}
helm.sh/chart: {{ include "vx-cloud.chart" . }}
{{ include "vx-cloud.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Base selector labels (release-scoped, no per-role component).
*/}}
{{- define "vx-cloud.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vx-cloud.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The image reference; tag defaults to the chart appVersion.
*/}}
{{- define "vx-cloud.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
ServiceAccount name to use.
*/}}
{{- define "vx-cloud.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "vx-cloud.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The Secret name holding the auth token (BYO or chart-rendered).
*/}}
{{- define "vx-cloud.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-auth" (include "vx-cloud.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
The coordinator Service DNS workers dial (in-cluster).
*/}}
{{- define "vx-cloud.coordinatorUrl" -}}
{{- printf "http://%s-coordinator:%d" (include "vx-cloud.fullname" .) (int .Values.coordinator.port) -}}
{{- end -}}

{{/*
Shared env block (auth token + cache backend config) injected into every role.
*/}}
{{- define "vx-cloud.commonEnv" -}}
{{- if or .Values.auth.token .Values.auth.existingSecret }}
- name: VX_CLOUD_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "vx-cloud.authSecretName" . }}
      key: token
{{- end }}
{{- if eq .Values.cache.backend "fs" }}
- name: VX_CLOUD_CACHE_BACKEND
  value: "fs"
- name: VX_CLOUD_CACHE_DIR
  value: {{ .Values.cache.fs.mountPath | quote }}
{{- else }}
- name: VX_CLOUD_CACHE_BACKEND
  value: {{ .Values.cache.backend | quote }}
- name: VX_CLOUD_CACHE_ENDPOINT
  value: {{ .Values.cache.s3.endpoint | quote }}
- name: VX_CLOUD_CACHE_BUCKET
  value: {{ .Values.cache.s3.bucket | quote }}
- name: VX_CLOUD_CACHE_REGION
  value: {{ .Values.cache.s3.region | quote }}
- name: VX_CLOUD_CACHE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cache.s3.existingSecret | default (printf "%s-cache" (include "vx-cloud.fullname" .)) }}
      key: accessKeyId
- name: VX_CLOUD_CACHE_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.cache.s3.existingSecret | default (printf "%s-cache" (include "vx-cloud.fullname" .)) }}
      key: secretAccessKey
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}
