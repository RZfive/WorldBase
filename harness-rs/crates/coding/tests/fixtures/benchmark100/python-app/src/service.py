import os
from dataclasses import dataclass

MAX_RETRIES = 3
_private_cache = {}


@dataclass
class ServiceConfig:
    name: str
    retries: int = MAX_RETRIES


class Service:
    def __init__(self, config: ServiceConfig):
        self.config = config

    def fetch(self, key):
        return load_value(key)

    def reset(self):
        _private_cache.clear()


def load_value(key):
    return _private_cache.get(key)


def health_check():
    return True
