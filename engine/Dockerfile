FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 FIREWATCH_DB=/data/firewatch.db
COPY engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY engine ./engine
RUN mkdir -p /data
EXPOSE 8010
CMD ["uvicorn", "engine.app.main:app", "--host", "0.0.0.0", "--port", "8010"]
