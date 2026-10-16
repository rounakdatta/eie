#!/usr/bin/env python3
"""Run a command, and run it again whenever it steps aside for memory.

  python3 scripts/gently.py LOG COMMAND...

transcribe.py exits with status 75 when the container's memory nears its cap. This waits until
memory has receded below RESUME and work/PAUSE is absent, then starts the command again. Any
other exit status ends the loop. Output goes to LOG.
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESUME = 5 * 2**30  # container anon + shmem


def container_memory():
    with open("/sys/fs/cgroup/memory.stat") as f:
        stat = dict(line.split() for line in f)
    return int(stat["anon"]) + int(stat["shmem"])


def main(log_path, command):
    with open(log_path, "a") as log:
        while True:
            while os.path.exists(os.path.join(ROOT, "work", "PAUSE")) or container_memory() > RESUME:
                time.sleep(60)
            code = subprocess.call(command, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            log.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "exit": code}) + "\n")
            log.flush()
            if code != 75:
                return code
            time.sleep(120)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
