import asyncio
import asyncpg
import os

async def check_slides():
    # Database connection parameters (extracted from converter/auth.py or env)
    # Defaulting to standard dev credentials
    dsn = "postgresql://postgres:postgres@localhost:5432/dicom_server"
    
    try:
        conn = await asyncpg.connect(dsn)
        print("Connected to database.")
        
        rows = await conn.fetch("SELECT id, orthanc_study_id, owner_id, display_name FROM slides ORDER BY created_at DESC LIMIT 5")
        
        if not rows:
            print("No slides found in database.")
        else:
            print(f"Found {len(rows)} recent slides:")
            for row in rows:
                print(f"ID: {row['id']} | Orthanc ID: {row['orthanc_study_id']} | Owner ID: {row['owner_id']} | Name: {row['display_name']}")
        
        await conn.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(check_slides())
