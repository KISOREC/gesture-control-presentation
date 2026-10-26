from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

MODEL_URL = "https://storage.googleapis.com/mediapipe-assets/hand_landmarker.task"
MODEL_SHA256 = "2ed44f10872e87a5834b9b1130fb9ada30e107af2c6fcc4562ad788aca4e7bc4"
PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH = PROJECT_DIR / "models" / "hand_landmarker.task"
DOWNLOAD_PATH = MODEL_PATH.with_suffix(".task.download")


def main():
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)

    if MODEL_PATH.is_file() and sha256(MODEL_PATH.read_bytes()).hexdigest() == MODEL_SHA256:
        print(f"Model already exists: {MODEL_PATH}")
        return

    try:
        with urlopen(MODEL_URL, timeout=60) as response:
            with DOWNLOAD_PATH.open("wb") as model_file:
                while chunk := response.read(1024 * 1024):
                    model_file.write(chunk)

        if sha256(DOWNLOAD_PATH.read_bytes()).hexdigest() != MODEL_SHA256:
            raise RuntimeError("Downloaded hand landmark model failed SHA-256 verification.")

        DOWNLOAD_PATH.replace(MODEL_PATH)
    finally:
        DOWNLOAD_PATH.unlink(missing_ok=True)

    print(f"Downloaded and verified model: {MODEL_PATH}")


if __name__ == "__main__":
    main()
