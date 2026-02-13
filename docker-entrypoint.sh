#!/bin/sh

# Install and configure Plastic SCM client (non-fatal - server starts regardless)
if [ -n "$PLASTIC_USER" ] && [ -n "$PLASTIC_PASSWORD" ] && [ -n "$PLASTIC_SERVER" ]; then
  if ! command -v cm >/dev/null 2>&1; then
    echo "=== Installing Plastic SCM client ==="
    # Use modern gpg keyring approach (apt-key is deprecated in Debian 12+)
    echo "Adding Plastic SCM GPG key..."
    wget -qO - https://www.plasticscm.com/plasticrepo/stable/debian/Release.key | gpg --dearmor -o /usr/share/keyrings/plasticscm-stable.gpg 2>&1
    echo "deb [signed-by=/usr/share/keyrings/plasticscm-stable.gpg] https://www.plasticscm.com/plasticrepo/stable/debian ./" > /etc/apt/sources.list.d/plasticscm-stable.list
    echo "Updating package lists..."
    if apt-get update 2>&1; then
      echo "Installing plasticscm-client-core..."
      if apt-get install -y --no-install-recommends plasticscm-client-core 2>&1; then
        rm -rf /var/lib/apt/lists/*
        echo "=== Plastic SCM client installed successfully ==="
      else
        echo "WARNING: apt-get install plasticscm-client-core failed"
      fi
    else
      echo "WARNING: apt-get update failed"
    fi
  else
    echo "Plastic SCM client already installed: $(cm version 2>/dev/null || echo 'unknown version')"
  fi

  if command -v cm >/dev/null 2>&1; then
    echo "Configuring Plastic SCM client for server: $PLASTIC_SERVER"
    PLASTIC_HOST=$(echo "$PLASTIC_SERVER" | sed 's/@cloud$/@cloud.plasticscm.com:8088/')
    echo "Server host: $PLASTIC_HOST"
    echo "User: $PLASTIC_USER"
    if su -s /bin/sh nodejs -c "mkdir -p \$HOME/.plastic4 && /opt/plasticscm5/client/clconfigureclient --workingmode=LDAPWorkingMode --server=\"$PLASTIC_HOST\" --user=\"$PLASTIC_USER\" --password=\"$PLASTIC_PASSWORD\"" 2>&1; then
      echo "=== Plastic SCM client configured ==="
    else
      echo "WARNING: clconfigureclient failed"
    fi
  fi
else
  echo "Plastic SCM: credentials not set (PLASTIC_USER, PLASTIC_PASSWORD, PLASTIC_SERVER)"
fi

# Drop to nodejs user and run the command
echo "Starting application..."
exec su -s /bin/sh nodejs -c "$*"
