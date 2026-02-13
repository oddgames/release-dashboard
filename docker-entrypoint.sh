#!/bin/sh

# Install and configure Plastic SCM client (non-fatal - server starts regardless)
if [ -n "$PLASTIC_USER" ] && [ -n "$PLASTIC_PASSWORD" ] && [ -n "$PLASTIC_SERVER" ]; then
  if ! command -v cm >/dev/null 2>&1; then
    echo "=== Installing Plastic SCM client ==="
    # Download .deb directly (bypasses APT repo issues)
    DEB_URL="https://www.plasticscm.com/plasticrepo/stable/debian/amd64/plasticscm-client-core_11.0.16.9943_amd64.deb"
    DEB_FILE="/tmp/plasticscm-client-core.deb"
    echo "Downloading: $DEB_URL"
    if wget -q -O "$DEB_FILE" "$DEB_URL" 2>&1; then
      echo "Download complete ($(du -h "$DEB_FILE" | cut -f1))"
      echo "Installing .deb package..."
      if dpkg -i "$DEB_FILE" 2>&1; then
        echo "=== Plastic SCM client installed ==="
      else
        echo "dpkg failed, attempting to fix dependencies..."
        apt-get update -qq 2>&1 && apt-get install -f -y 2>&1
        if command -v cm >/dev/null 2>&1; then
          echo "=== Plastic SCM client installed (with dependency fix) ==="
        else
          echo "WARNING: Plastic SCM install failed"
        fi
      fi
      rm -f "$DEB_FILE"
    else
      echo "WARNING: Failed to download Plastic SCM .deb"
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
