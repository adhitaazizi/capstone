import logging
import os
import time

from dotenv import load_dotenv

from consumer import PersistenceConsumer
from persistence import SupabasePersistence

LOGGER = logging.getLogger(__name__)
MAX_BACKOFF_SECONDS = 60


def main() -> None:
    load_dotenv()
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    rabbitmq_url = os.environ.get("RABBITMQ_URL")
    if not rabbitmq_url:
        raise RuntimeError("RABBITMQ_URL is required")

    persistence = SupabasePersistence()
    backoff_seconds = 1

    while True:
        consumer = PersistenceConsumer(rabbitmq_url, persistence)
        started_at = time.monotonic()

        try:
            should_reconnect = consumer.run()
        except KeyboardInterrupt:
            LOGGER.info("Shutting down persistence worker")
            consumer.close()
            break
        except Exception:
            LOGGER.exception("Persistence worker crashed")
            should_reconnect = True

        if not should_reconnect:
            break

        if time.monotonic() - started_at > MAX_BACKOFF_SECONDS:
            backoff_seconds = 1

        LOGGER.info("Reconnecting in %s seconds", backoff_seconds)
        time.sleep(backoff_seconds)
        backoff_seconds = min(backoff_seconds * 2, MAX_BACKOFF_SECONDS)


if __name__ == "__main__":
    main()
