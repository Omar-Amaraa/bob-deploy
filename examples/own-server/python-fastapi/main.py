from fastapi import FastAPI
from fastapi.responses import HTMLResponse

# Bob Deploy starts this with: .venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT
# so the module must be main.py and the FastAPI object must be called `app`.
app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    # Health check: Bob Deploy calls GET / before switching traffic to a new release.
    return "<h1>It works.</h1><p>Deployed by Bob Deploy from examples/own-server/python-fastapi.</p>"


@app.get("/api/hello")
def hello() -> dict[str, str]:
    return {"message": "Hello from the server"}
