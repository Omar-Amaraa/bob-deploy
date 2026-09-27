import os

from flask import Flask, jsonify

# Bob Deploy starts this with: .venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT
# so the module must be app.py and the Flask object must be called `app`.
app = Flask(__name__)


@app.get("/")
def index():
    # Health check: Bob Deploy calls GET / before switching traffic to a new release.
    return "<h1>It works.</h1><p>Deployed by Bob Deploy from examples/own-server/python-flask.</p>"


@app.get("/api/hello")
def hello():
    return jsonify(message="Hello from the server")


if __name__ == "__main__":
    # Local development only; on the server gunicorn runs the app.
    app.run(port=int(os.environ.get("PORT", 5000)), debug=True)
