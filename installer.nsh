; 高 DPI 支持
ManifestDPIAware true

!include "WordFunc.nsh"

!macro customInit
  ; 设置 DPI 感知
  System::Call 'USER32::SetProcessDPIAware()'
!macroend

; 在安装开始前修正安装目录
!macro preInit
  ; 如果安装目录不以 WeFlow 结尾，自动追加
  ${WordFind} "$INSTDIR" "\" "-1" $R0
  ${If} $R0 != "WeFlow"
    StrCpy $INSTDIR "$INSTDIR\WeFlow"
  ${EndIf}
!macroend
