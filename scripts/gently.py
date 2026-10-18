#!/usr/bin/env python3
"""Run a command gently: pause it under CPU pressure, run it again after it steps aside for memory.

  python3 scripts/gently.py LOG COMMAND...

- CPU: while the node's CPU pressure (PSI "some", 10 s average) is above HIGH_CPU, the command
  is suspended with SIGSTOP. It continues once pressure falls below LOW_CPU, so deploys and
  builds on the node always come first.
- Memory: transcribe.py exits with status 75 when the container's memory nears its cap; this
  also kills the command if it nears the cap while suspended. Either way the command starts
  again once memory has receded below RESUME and work/PAUSE is absent.
Any other exit status ends the loop. Output goes to LOG.
"""
import json
import os
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESUME, MEMORY_LIMIT = 4.5 * 2**30, 6.5 * 2**30  # container anon + shmem
HIGH_CPU, LOW_CPU = 45.0, 25.0  # PSI some avg10, percent


def container_memory():
    with open("/sys/fs/cgroup/memory.stat") as f:
        stat = dict(line.split() for line in f)
    return int(stat["anon"]) + int(stat["shmem"])


def cpu_pressure():
    with open("/proc/pressure/cpu") as f:
        return float(f.readline().split()[1].split("=")[1])


def main(log_path, command):
    with open(log_path, "a") as log:
        def note(**fields):
            log.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), **fields}) + "\n")
            log.flush()

        while True:
            while os.path.exists(os.path.join(ROOT, "work", "PAUSE")) or container_memory() > RESUME:
                time.sleep(60)
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            stopped = False
            while child.poll() is None:
                time.sleep(15)
                pressure = cpu_pressure()
                if not stopped and pressure > HIGH_CPU:
                    child.send_signal(signal.SIGSTOP)
                    stopped = True
                    note(paused="cpu pressure", psi=pressure)
                elif stopped and pressure < LOW_CPU:
                    child.send_signal(signal.SIGCONT)
                    stopped = False
                    note(resumed="cpu pressure", psi=pressure)
                if stopped and container_memory() > MEMORY_LIMIT:
                    child.kill()
            code = 75 if child.returncode == -signal.SIGKILL else child.returncode
            note(exit=code)
            if code != 75:
                return code
            time.sleep(120)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
