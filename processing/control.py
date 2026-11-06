"""Suspend/resume only the processes in one worker's Windows Job Object."""
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes


def main(action, value):
    if os.name != 'nt':
        raise RuntimeError('当前任务暂停仅支持 Windows')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    native = ctypes.WinDLL('ntdll')
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenJobObjectW.restype = wintypes.HANDLE
    kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    for operation in (native.NtSuspendProcess, native.NtResumeProcess):
        operation.argtypes = [wintypes.HANDLE]
        operation.restype = wintypes.LONG
    handles = []

    def open_process(pid, created=None):
        handle = kernel.OpenProcess(0x0800 | 0x1000, False, pid)
        if not handle:
            error = ctypes.get_last_error()
            if error in (87, 1168):
                return None
            raise ctypes.WinError(error)
        handles.append(handle)
        stamp, end, kernel_time, user_time = [wintypes.FILETIME() for _ in range(4)]
        code = wintypes.DWORD()
        if not kernel.GetProcessTimes(handle, ctypes.byref(stamp), ctypes.byref(end), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        identity = str((stamp.dwHighDateTime << 32) | stamp.dwLowDateTime)
        if code.value != 259 or created is not None and created != identity:
            return None
        return handle, {'pid': pid, 'created': identity}

    def resume(records):
        remaining = []
        # The worker was suspended first; resume its children before it.
        for record in reversed(records):
            try:
                opened = open_process(record['pid'], record['created'])
                if opened and native.NtResumeProcess(opened[0]) < 0:
                    remaining.append(record)
            except OSError:
                remaining.append(record)
        return list(reversed(remaining))

    try:
        if action == 'resume':
            return {'remaining': resume(json.loads(value))}
        if action != 'pause':
            raise ValueError('无效的任务控制操作')
        pid = int(value)
        root = open_process(pid)
        if root is None:
            return {'processes': []}
        job = None
        for _ in range(40):
            job = kernel.OpenJobObjectW(0x0004, False, f'Local\\FrameSequence-Worker-{pid}')
            if job:
                break
            code = wintypes.DWORD()
            kernel.GetExitCodeProcess(root[0], ctypes.byref(code))
            if code.value != 259:
                return {'processes': []}
            time.sleep(0.05)
        if not job:
            raise RuntimeError('任务进程尚未就绪，请稍后重试暂停')
        handles.append(job)

        def members():
            capacity = 32
            while capacity <= 65536:
                class ProcessList(ctypes.Structure):
                    _fields_ = [('assigned', wintypes.DWORD), ('count', wintypes.DWORD),
                                ('ids', ctypes.c_size_t * capacity)]
                data = ProcessList()
                if kernel.QueryInformationJobObject(job, 3, ctypes.byref(data), ctypes.sizeof(data), None):
                    return list(data.ids[:data.count])
                if ctypes.get_last_error() != 234:
                    raise ctypes.WinError(ctypes.get_last_error())
                capacity = max(capacity * 2, data.assigned + 16)
            raise RuntimeError('任务子进程数量异常')

        suspended, seen = [], set()
        try:
            # Freeze the worker first, then query its job repeatedly so a child
            # created during suspension cannot escape the pause.
            pending = [pid]
            while pending:
                for member in pending:
                    opened = root if member == pid else open_process(member)
                    seen.add(member)
                    if opened:
                        status = native.NtSuspendProcess(opened[0])
                        if status < 0:
                            code = wintypes.DWORD()
                            kernel.GetExitCodeProcess(opened[0], ctypes.byref(code))
                            if code.value == 259:
                                raise RuntimeError(f'暂停任务进程失败：0x{status & 0xffffffff:08x}')
                        else:
                            suspended.append(opened[1])
                pending = [member for member in members() if member not in seen]
            return {'processes': suspended}
        except BaseException:
            resume(suspended)
            raise
    finally:
        for handle in reversed(handles):
            kernel.CloseHandle(handle)


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1], sys.argv[2])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
