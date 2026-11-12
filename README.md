# PDF 뷰어

Windows용 로컬 PDF 뷰어입니다. 두 쪽 크기 정렬, 여백·색상·화질 조절, 사용자 책장, ChatGPT 영역 질문과 GitHub Releases 업데이트를 제공합니다.

## 설치와 업데이트

Releases의 PDFViewer-setup.zip을 모두 압축 해제한 뒤 PDFViewer/install.cmd를 실행하세요. 교재 PDF는 포함하지 않습니다. 기존 설치에 덮어 설치하면 기존 교재와 개인 설정을 유지합니다.

설치 후 책장의 업데이트 버튼으로 새 버전을 받습니다. PDFViewer-update.zip과 PDFViewer-update.json은 프로그램 내부 업데이트용입니다.

## 사용자 자료

책장 관리에서 PDF와 폴더를 등록하고 목차를 편집합니다. user-data 폴더의 PDF와 목차는 업데이트 때 보존됩니다.

개인 브라우저 프로필, GPT 프로젝트 연결 설정 및 PDF 자료는 이 저장소와 릴리스에 포함하지 않습니다.

## 새 버전 만들기

app-release.json의 version을 올리고 node packaging/update-build.cjs로 업데이트 파일을 생성합니다. 프로그램 파일과 업데이트 목록을 동일한 GitHub Release에 게시합니다.

사용한 PDF.js 및 기타 구성요소의 라이선스는 vendor 폴더를 참조하세요.
