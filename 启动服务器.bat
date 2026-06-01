@echo off
chcp 65001 >nul
title 魂斗罗 双人对战服务器
echo.
echo   正在启动魂斗罗双人对战服务器...
echo.
cd /d "%~dp0"
node server.js
pause
