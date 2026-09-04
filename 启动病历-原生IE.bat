@echo off
chcp 936 >nul
title 启动原生IE病历浏览器
echo 正在启动 Windows 原生 32 位 IE 浏览器...
wscript "%~dp0启动病历-原生IE.vbs" %*
