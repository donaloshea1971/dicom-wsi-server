import requests

study_id = '52391c74-f5a241d4-dbf7ae3c-93247a93-53c02305'

r = requests.get(f'http://localhost:8042/studies/{study_id}', auth=('admin','orthanc'))
study = r.json()
series_ids = study.get('Series', [])

if series_ids:
    r2 = requests.get(f'http://localhost:8042/series/{series_ids[0]}', auth=('admin','orthanc'))
    series = r2.json()
    instance_ids = series.get('Instances', [])
    
    if instance_ids:
        inst_id = instance_ids[0]
        r3 = requests.get(f'http://localhost:8042/instances/{inst_id}/simplified-tags', auth=('admin','orthanc'))
        tags = r3.json()
        
        print('Sierra-ICC Metadata:')
        print('=' * 50)
        for k in ['Manufacturer', 'ManufacturerModelName', 'SoftwareVersions', 'Modality', 'ImageType', 'InstitutionName']:
            print(f'{k}: {tags.get(k, "N/A")}')
        
        # Get pyramid info
        r4 = requests.get(f'http://localhost:8042/wsi/pyramids/{study_id}', auth=('admin','orthanc'))
        if r4.status_code == 200:
            p = r4.json()
            print(f'\nPyramid: {p["TotalWidth"]}x{p["TotalHeight"]}')
            print(f'Levels: {len(p["Resolutions"])}')

