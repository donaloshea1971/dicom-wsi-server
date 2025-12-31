FROM postgres:15-alpine
ENV POSTGRES_USER=orthanc
ENV POSTGRES_PASSWORD=orthanc_secret
ENV POSTGRES_DB=orthanc

# Apply performance tuning via command-line args
CMD ["postgres", "-c", "shared_buffers=384MB", "-c", "effective_cache_size=1GB", "-c", "work_mem=16MB", "-c", "maintenance_work_mem=128MB", "-c", "random_page_cost=1.1", "-c", "effective_io_concurrency=200", "-c", "max_parallel_workers_per_gather=2", "-c", "checkpoint_completion_target=0.9", "-c", "wal_buffers=16MB", "-c", "max_connections=100"]
