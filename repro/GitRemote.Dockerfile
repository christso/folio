FROM folio-retirement-app:c5545fd
RUN apk add --no-cache git-daemon && test -x /usr/libexec/git-core/git-http-backend
