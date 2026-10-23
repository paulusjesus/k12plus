#!/bin/sh
# Creates the test certificate for item13.measure.js: a throwaway certificate authority,
# trusted only by the test browser (through a separate HOME), and a certificate for the
# stand-in servers. Browsers cache nothing from sites they do not trust, so this is
# needed for return visits to be measured correctly.
# Usage: sh item13-tls.sh <folder>   then run the test with TLS_DIR=<folder>
set -e
D="${1:?folder}"; mkdir -p "$D/home/.pki/nssdb"; cd "$D"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 30 -subj "/CN=K12Plus test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=k12plus.app" 2>/dev/null
printf "subjectAltName=DNS:k12plus.app,DNS:www.k12plus.app,DNS:unpkg.com,DNS:fonts.googleapis.com,DNS:fonts.gstatic.com,DNS:uwqbjjzjdnjlbicxrwnp.supabase.co\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -days 30 -extfile ext.cnf 2>/dev/null
certutil -d sql:home/.pki/nssdb -N --empty-password
certutil -d sql:home/.pki/nssdb -A -n k12test -t "C,," -i ca.pem
echo "ready: TLS_DIR=$D"
