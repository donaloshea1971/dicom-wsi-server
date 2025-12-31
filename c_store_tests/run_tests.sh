#!/bin/bash

# Bash script to run C-STORE tests on Linux/Mac

echo -e "\033[36mC-STORE Validation Test Runner\033[0m"
echo -e "\033[36m==============================\033[0m"
echo ""

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo -e "\033[33mCreating virtual environment...\033[0m"
    python3 -m venv venv
fi

# Activate virtual environment
echo -e "\033[33mActivating virtual environment...\033[0m"
source venv/bin/activate

# Install dependencies
echo -e "\033[33mInstalling dependencies...\033[0m"
pip install -r requirements.txt

# Run the test suite
echo -e "\n\033[32mRunning C-STORE validation tests...\033[0m"
echo -e "\033[32m===================================\033[0m"
python test_c_store.py

# Deactivate virtual environment
deactivate

echo -e "\n\033[36mTest execution complete!\033[0m"
echo -e "\033[36mCheck the output above for test results.\033[0m"
echo ""
echo -e "\033[33mTo send individual files, use:\033[0m"
echo -e "\033[37m  python simple_c_store_client.py <dicom_file>\033[0m"
echo ""
read -p "Press Enter to exit..."
