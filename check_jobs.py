import requests

# Check conversion jobs
print('=== Conversion Jobs ===')
try:
    r = requests.get('http://144.126.203.208:8000/jobs', timeout=10)
    jobs = r.json()
    if not jobs:
        print('No jobs found')
    else:
        for job in jobs:
            print(f"Job {job.get('job_id')}: {job.get('status')} - {job.get('filename', 'unknown')}")
            if job.get('error'):
                print(f"  Error: {job.get('error')}")
except Exception as e:
    print(f'Error: {e}')

print()
print('=== Service Status ===')
try:
    r = requests.get('http://144.126.203.208:8000/status', timeout=10)
    print(r.json())
except Exception as e:
    print(f'Error: {e}')
