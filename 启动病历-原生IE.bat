@echo off
chcp 65001 >nul 2>nul
title 启动病历-原生IE
wscript "%~dp0launch_ie.vbs" %*
