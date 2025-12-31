import requests
auth = ('admin', 'orthanc')
r = requests.get('http://localhost:8042/wsi/pyramids/315c8242-882c1e86-121fe508-4adc7e30-07a7d6c1', auth=auth)
p = r.json()
print('Leica Full Pyramid:')
print('Resolutions:', p["Resolutions"])
for i in range(len(p['Resolutions'])):
    print(f'Level {i}: res={p["Resolutions"][i]}, size={p["Sizes"][i]}, tiles={p["TilesCount"][i]}, tileSize={p["TilesSizes"][i]}')
