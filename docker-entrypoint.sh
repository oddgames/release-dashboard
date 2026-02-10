#!/bin/sh
set -e

# Configure Plastic SCM client if credentials are provided
if [ -n "$PLASTIC_USER" ] && [ -n "$PLASTIC_PASSWORD" ] && [ -n "$PLASTIC_SERVER" ]; then
  echo "Configuring Plastic SCM client for server: $PLASTIC_SERVER"
  # Convert "orgname@cloud" to "orgname@cloud.plasticscm.com:8088"
  PLASTIC_HOST=$(echo "$PLASTIC_SERVER" | sed 's/@cloud$/@cloud.plasticscm.com:8088/')
  mkdir -p "$HOME/.plastic4"
  /opt/plasticscm5/client/clconfigureclient --workingmode=LDAPWorkingMode --server="$PLASTIC_HOST" --user="$PLASTIC_USER" --password="$PLASTIC_PASSWORD"
  echo "Plastic SCM client configured"
else
  echo "Plastic SCM credentials not set (PLASTIC_USER, PLASTIC_PASSWORD, PLASTIC_SERVER) - cm commands will fail"
fi

exec "$@"
