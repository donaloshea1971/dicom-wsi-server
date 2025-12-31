import requests
auth = ('admin', 'orthanc')
r = requests.get('http://localhost:8042/wsi/pyramids/fc2e90ad-4599bc0d-218785fd-114fa180-9a6228bf', auth=auth)
p = r.json()
print('3DHISTECH-1 Full Pyramid:')
print('Resolutions:', p["Resolutions"])
for i in range(len(p['Resolutions'])):
    print(f'Level {i}: res={p["Resolutions"][i]}, size={p["Sizes"][i]}, tiles={p["TilesCount"][i]}, tileSize={p["TilesSizes"][i]}')
