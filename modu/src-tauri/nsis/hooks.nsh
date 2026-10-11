; 墨读 · NSIS 安装器钩子（2026-10-01 用户反馈：升级时应用在运行 ⇒ 旧卸载器删不掉
; modu.exe ⇒「无法卸载」中止安装）。
;
; 背景：tauri 模板的 CheckIfAppIsRunning 走 Restart Manager（RmShutdown 强杀），
; 但两类场景会失败——①应用开着「未保存改动」的关窗确认浮层（RM 等待超时）；
; ②第三方防护（火绒等）拦截进程终止。这里在卸载/装文件的**最前面**先无条件
; taskkill，把「应用正在运行」这个故障面整个消掉。
;
; taskkill 退出码一律忽略（无进程时返回 128——那本来就是要达到的状态）。
; 宏体在展开点才求值 ${MAINBINARYNAME}（install.nsi 的 !define 在 include 之后，
; 宏定义时未定义不影响使用点）。

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "关闭运行中的墨读……"
  nsExec::ExecToStack 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
  Pop $0
  Pop $1
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "关闭运行中的墨读……"
  nsExec::ExecToStack 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
  Pop $0
  Pop $1
  Sleep 500
!macroend
