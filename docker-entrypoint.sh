#!/bin/sh

# Install and configure Plastic SCM client (non-fatal - server starts regardless)
if [ -n "$PLASTIC_USER" ] && [ -n "$PLASTIC_PASSWORD" ] && [ -n "$PLASTIC_SERVER" ]; then
  if ! command -v cm >/dev/null 2>&1; then
    echo "Installing Plastic SCM client..."
    echo "deb https://www.plasticscm.com/plasticrepo/stable/debian/ ./" > /etc/apt/sources.list.d/plasticscm-stable.list
    wget -qO - https://www.plasticscm.com/plasticrepo/stable/debian/Release.key | apt-key add - 2>/dev/null
    if apt-get update -qq && apt-get install -y --no-install-recommends plasticscm-client-core; then
      rm -rf /var/lib/apt/lists/*
      echo "Plastic SCM client installed"
    else
      echo "WARNING: Failed to install Plastic SCM client - cm commands will not work"
    fi
  fi

  if command -v cm >/dev/null 2>&1; then
    echo "Configuring Plastic SCM client for server: $PLASTIC_SERVER"
    PLASTIC_HOST=$(echo "$PLASTIC_SERVER" | sed 's/@cloud$/@cloud.plasticscm.com:8088/')
    su -s /bin/sh nodejs -c "mkdir -p \$HOME/.plastic4 && /opt/plasticscm5/client/clconfigureclient --workingmode=LDAPWorkingMode --server=\"$PLASTIC_HOST\" --user=\"$PLASTIC_USER\" --password=\"$PLASTIC_PASSWORD\"" && echo "Plastic SCM client configured" || echo "WARNING: Failed to configure Plastic SCM client"
  fi
else
  echo "Plastic SCM credentials not set (PLASTIC_USER, PLASTIC_PASSWORD, PLASTIC_SERVER) - cm commands will fail"
fi

# Drop to nodejs user and run the command
exec su -s /bin/sh nodejs -c "$*"
