{{- define "medikong-service.image" -}}
{{- $image := .Values.image -}}
{{- $rawTag := toString (default "" $image.tag) -}}
{{- $rawDigest := toString (default "" $image.digest) -}}
{{- $tag := trim $rawTag -}}
{{- $digest := trim $rawDigest -}}
{{- if or (ne $rawTag $tag) (ne $rawDigest $digest) -}}
{{- fail "image.tag and image.digest must not contain leading or trailing whitespace" -}}
{{- end -}}
{{- $hasTag := ne $tag "" -}}
{{- $hasDigest := ne $digest "" -}}
{{- if eq $hasTag $hasDigest -}}
{{- fail "exactly one of image.tag or image.digest must be set" -}}
{{- end -}}
{{- if and $hasDigest (not (regexMatch "^sha256:[0-9a-f]{64}$" $digest)) -}}
{{- fail "image.digest must match sha256 followed by 64 lowercase hexadecimal characters" -}}
{{- end -}}
{{- $repository := required "image.repository must be set" $image.repository -}}
{{- $base := $repository -}}
{{- with $image.registry -}}
{{- $base = printf "%s/%s" (trimSuffix "/" .) (trimPrefix "/" $repository) -}}
{{- end -}}
{{- if $hasDigest -}}
{{- printf "%s@%s" $base $digest -}}
{{- else -}}
{{- printf "%s:%s" $base $tag -}}
{{- end -}}
{{- end -}}

{{- define "medikong-service.imageVersion" -}}
{{- $image := .Values.image -}}
{{- $version := trim (toString (default "" $image.version)) -}}
{{- $tag := trim (toString (default "" $image.tag)) -}}
{{- $digest := trim (toString (default "" $image.digest)) -}}
{{- if $version -}}
{{- $version -}}
{{- else if $tag -}}
{{- $tag -}}
{{- else -}}
{{- $digest -}}
{{- end -}}
{{- end -}}
