FROM python:3.11-slim

LABEL org.opencontainers.image.title="Message Hub" \
      org.opencontainers.image.description="Customer, tag, and messaging hub for Quo and other connectors." \
      org.opencontainers.image.vendor="Message Hub" \
      org.opencontainers.image.url="http://192.168.50.230:3000" \
      org.opencontainers.image.icon="http://192.168.50.230:3000/app-icon.svg"

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY server.py .
COPY public/ public/

# DB lives in a mounted volume so it persists across restarts
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/quo_manager.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import json, urllib.request; r=urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=3); raise SystemExit(0 if json.load(r).get('ok') else 1)"

CMD ["python", "server.py"]
