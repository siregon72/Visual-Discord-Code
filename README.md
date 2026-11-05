# Visual Discord Code

**Discord 대화를 VS Code의 코드처럼 보여 주는 데스크톱 앱입니다.**

대화방은 탐색기의 파일로, 메시지는 React·TypeScript 코드 안의 문자열로 표시됩니다. 코드 편집기처럼 보이는 화면에서 실제 Discord 대화를 읽고 텍스트 메시지를 보낼 수 있습니다. Electron으로 실행되는 독립 앱이라 VS Code는 따로 필요하지 않습니다.

## 주요 기능

- **파일처럼 여는 대화:** `direct` 폴더에서 DM을, 서버 폴더에서 채널을 선택합니다.
- **코드로 보이는 메시지:** 대화가 변수·함수·JSX 사이에 섞여 표시됩니다. 받은 메시지는 파란 막대, 보낸 메시지는 초록 막대로 구분합니다.
- **코드 줄에서 답장:** 맨 아래 `setDraft("…");` 입력 줄에 내용을 쓰고 Enter로 보냅니다. Shift+Enter로 줄을 바꿀 수 있습니다.
- **전송 후 바로 입력:** 전송 요청을 전달하면 입력을 마칩니다. 전송 결과는 대화에서 직접 확인하며, 자동 결과 확인이나 확인 대기 안내는 없습니다.
- **화면 꾸미기:** 대화 이름을 `Header.tsx` 같은 코드 파일명으로 바꾸거나, `Spaces`로 메시지 사이의 장식 코드 양을 조절할 수 있습니다.
- **원래 Discord 화면 전환:** 첨부·통화·메시지 수정과 삭제 등이 필요하면 **원래 화면**으로 전환할 수 있습니다.

표시되는 React·TypeScript 코드는 대화를 표현하기 위한 장식이며 실행되지 않습니다.

## 클론해서 실행하기

Git과 **Node.js 24 이상**이 필요합니다.

```powershell
git clone https://github.com/siregon72/Visual-Discord-Code.git
cd Visual-Discord-Code
npm ci
npm start
```

실행한 앱에서 Discord 계정으로 로그인하면 코드 화면으로 돌아옵니다. 왼쪽 탐색기에서 대화를 선택해 사용하세요.

앱은 Discord 웹 화면에 표시된 대화를 읽고, 사용자가 보낸 문장을 Discord의 원래 입력창에 전달합니다. 로그인은 앱 안의 `discord.com` 페이지에서 진행합니다.

비공식 개인 프로젝트이며 Discord 및 Microsoft와 제휴하지 않습니다.
