"""Tie all worker descendants to its lifetime, including unexpected app exit."""
import ctypes
import os
import threading
from ctypes import wintypes

_job = None


def attach():
    global _job
    if os.name != 'nt':
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    class Limits(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('minimum', ctypes.c_size_t), ('maximum', ctypes.c_size_t),
                    ('active', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                    ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Limits), ('io', ctypes.c_ulonglong * 6),
                    ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                    ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    limits = Extended(); limits.basic.flags = 0x2000
    handle = kernel.CreateJobObjectW(None, None)
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise RuntimeError('无法创建 Windows 任务进程组')
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        kernel.CloseHandle(handle)
        raise RuntimeError('无法保护任务子进程生命周期')
    _job = handle
    parent = kernel.OpenProcess(0x00100000, False, os.getppid())
    if not parent:
        raise RuntimeError('无法监控桌面主进程')
    def watch():
        kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
        kernel.CloseHandle(parent)
        os._exit(2)  # Closing the job handle kills any remaining FFmpeg/AI children.
    threading.Thread(target=watch, daemon=True).start()
