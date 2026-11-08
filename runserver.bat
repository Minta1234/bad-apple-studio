@echo off 
echo 3
echo 2
echo 1

echo Starting backend server...
start node backend/server.js

echo Starting ngrok...
start ngrok http 4005
