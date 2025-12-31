"""Test C-STORE upload for 3DHISTECH-2"""
from pynetdicom import AE
from pydicom import dcmread
from pydicom.uid import VLWholeSlideMicroscopyImageStorage, JPEGBaseline8Bit
import os

f = r'C:\Users\donal.oshea_deciphex\DICOM Server\testdata\DICOM-native\3DHISTECH-2\5_0'

ae = AE(ae_title='CSTORE_CLIENT')
ae.add_requested_context(VLWholeSlideMicroscopyImageStorage, [JPEGBaseline8Bit])
ae.network_timeout = 1800
ae.acse_timeout = 1800
ae.dimse_timeout = 1800

print('Connecting to C-STORE proxy 144.126.203.208:4243...')
assoc = ae.associate('144.126.203.208', 4243, ae_title='CSTORE_PROXY')

if assoc.is_established:
    size_mb = os.path.getsize(f) / 1024 / 1024
    print(f'Sending {os.path.basename(f)} ({size_mb:.1f} MB)... this may take a few minutes')
    ds = dcmread(f)
    status = assoc.send_c_store(ds)
    if status and status.Status == 0:
        print('SUCCESS!')
    elif status:
        print(f'FAILED - Status: 0x{status.Status:04X}')
    else:
        print('No status returned')
    assoc.release()
else:
    print('Connection failed - check server logs')
