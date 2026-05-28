FROM python:3.11-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl wget jq git file binutils gdb nmap ffuf whatweb netcat-openbsd dnsutils whois openssl \
  exiftool binwalk tshark zip unzip john ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pwntools pycryptodome z3-solver sympy requests beautifulsoup4
WORKDIR /workspace
CMD ["sleep", "infinity"]
